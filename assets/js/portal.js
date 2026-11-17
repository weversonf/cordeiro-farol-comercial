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
const ADMIN_MASTER_EMAILS = new Set([
  'weverson.feitosa@cordeiroguindastes.com.br',
  'weverson.feitosa@cordeiroguindastes.com'
]);

function isAdminMaster(email) {
  return ADMIN_MASTER_EMAILS.has(String(email || '').trim().toLowerCase());
}

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

// URLs dos sistemas em produção
const URLS_SISTEMAS = {
  mapa: 'https://cordeiro-mapa-ocupacao.vercel.app',
  nps: 'https://cordeiro-nps.vercel.app',
  funil: 'https://cordeiro-funil-vendas.vercel.app'
};

// Base inicial padrão de contingência (sem senha exposta no código cliente)
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
let relatoriosCarregados = false;
let relatorioAtivo = 'catalogo';
let contratosCarregados = false;
let contratosPayload = null;
let contratosFiltroPrazo = 'todos';

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
              senha: row.senha || 'Cordeiro@2026',
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

      // Se a senha cadastrada ainda for a padrão de contingência e não for o master, exige troca
      const isMasterAdmin = currentUser.email.toLowerCase() === ADMIN_MASTER_EMAIL.toLowerCase();
      const senhaCadastrada = currentUser.senha || 'Cordeiro@2026';
      if (senhaCadastrada === 'Cordeiro@2026' && !isMasterAdmin) {
        document.getElementById('inputPrimeiroAcessoNovaSenha').value = '';
        document.getElementById('inputPrimeiroAcessoConfirma').value = '';
        const erroPrimeiro = document.getElementById('erroPrimeiroAcesso');
        if (erroPrimeiro) erroPrimeiro.style.display = 'none';
        abrirModal('modalPrimeiroAcesso');
      }
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
  const tabRelatoriosBtn = document.getElementById('tabRelatoriosBtn');
  const cardRelatorios = document.getElementById('cardRelatorios');
  const isMasterAdmin = isAdminMaster(currentUser.email);

  if (isMasterAdmin) {
    tabGestaoBtn.style.display = 'flex';
    tabRelatoriosBtn.style.display = 'flex';
    cardRelatorios.style.display = 'flex';
  } else {
    tabGestaoBtn.style.display = 'none';
    tabRelatoriosBtn.style.display = 'none';
    cardRelatorios.style.display = 'none';
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
    if (isAdminMaster(currentUser?.email)) {
      switchTab('gestao');
    }
  });
  document.getElementById('tabRelatoriosBtn').addEventListener('click', () => {
    if (isAdminMaster(currentUser?.email)) {
      switchTab('relatorios');
    }
  });
  document.getElementById('btnOpenRelatorios').addEventListener('click', () => {
    if (isAdminMaster(currentUser?.email)) {
      switchTab('relatorios');
    }
  });
  configurarControlesRelatorios();

  // Esqueci senha
  document.getElementById('btnAbrirEsqueci').addEventListener('click', () => abrirModal('modalEsqueci'));
  document.getElementById('btnFecharEsqueci').addEventListener('click', () => fecharModal('modalEsqueci'));
  document.getElementById('formEsqueci').addEventListener('submit', handleEnviarEsqueci);

  // Redefinir Senha (Recovery)
  const btnFecharRec = document.getElementById('btnFecharRecovery');
  if (btnFecharRec) btnFecharRec.addEventListener('click', () => fecharModal('modalNovaSenhaRecovery'));
  const formRec = document.getElementById('formNovaSenhaRecovery');
  if (formRec) formRec.addEventListener('submit', handleSalvarNovaSenhaRecovery);

  // Primeiro Acesso (Troca Obrigatória de Senha)
  const formPrimeiro = document.getElementById('formPrimeiroAcesso');
  if (formPrimeiro) formPrimeiro.addEventListener('submit', handleSalvarPrimeiroAcesso);
  const btnCancPrimeiro = document.getElementById('btnCancelarPrimeiroAcesso');
  if (btnCancPrimeiro) btnCancPrimeiro.addEventListener('click', () => {
    fecharModal('modalPrimeiroAcesso');
    handleLogout();
  });

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

  // Validação de senha + sessão Supabase Auth
  const isMaster = isAdminMaster(email);
  const senhaCadastrada = user.senha || '';
  let authSessaoValida = false;

  if (sbClient && sbClient.auth) {
    try {
      const { data: authData, error: authErr } = await sbClient.auth.signInWithPassword({ email, password: senha });
      if (!authErr && authData?.session?.access_token) {
        authSessaoValida = true;
      }
    } catch (authEx) {
      console.warn('Aviso ao autenticar no Supabase Auth:', authEx);
    }
  }

  const senhaTabelaValida = Boolean(senhaCadastrada) && senha === senhaCadastrada;
  if (!senhaTabelaValida && !authSessaoValida) {
    erroBox.textContent = 'Senha incorreta. Verifique os dados digitados ou utilize "Esqueci minha senha".';
    erroBox.style.display = 'flex';
    return;
  }

  currentUser = user;
  localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify(currentUser));
  showAppScreen();

  // Troca obrigatória no primeiro acesso caso ainda use a senha provisória padrão
  if (senhaCadastrada === 'Cordeiro@2026' && !isMaster) {
    document.getElementById('inputPrimeiroAcessoNovaSenha').value = '';
    document.getElementById('inputPrimeiroAcessoConfirma').value = '';
    const erroPrimeiro = document.getElementById('erroPrimeiroAcesso');
    if (erroPrimeiro) erroPrimeiro.style.display = 'none';
    abrirModal('modalPrimeiroAcesso');
    return;
  }

  showToast(`Autenticado com sucesso. Bem-vindo, ${user.nome}!`, 'success');
}

async function handleLogout() {
  localStorage.removeItem(STORAGE_KEY_AUTH);
  currentUser = null;
  relatoriosCarregados = false;
  contratosCarregados = false;
  contratosPayload = null;
  relatorioAtivo = 'catalogo';
  if (sbClient && sbClient.auth) {
    try { await sbClient.auth.signOut(); } catch (_) {}
  }
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
  } else if (tab === 'gestao' && isAdminMaster(currentUser?.email)) {
    document.getElementById('tabGestaoBtn').classList.add('active');
    document.getElementById('viewGestao').classList.add('active');
    renderTabelaUsuarios();
  } else if (tab === 'relatorios' && isAdminMaster(currentUser?.email)) {
    document.getElementById('tabRelatoriosBtn').classList.add('active');
    document.getElementById('viewRelatorios').classList.add('active');
    abrirRelatorio(relatorioAtivo);
  }
}

function abrirRelatorio(tipo = 'catalogo') {
  relatorioAtivo = tipo;
  const catalogo = document.getElementById('relatoriosCatalogo');
  const visaoGeral = document.getElementById('relatorioVisaoGeral');
  const contratos = document.getElementById('relatorioContratos');
  const btnVoltar = document.getElementById('btnVoltarCatalogoRelatorios');
  const acoesVisaoGeral = document.getElementById('acoesVisaoGeral');
  const acoesContratos = document.getElementById('acoesContratos');
  const titulo = document.getElementById('relatoriosTitulo');
  const desc = document.getElementById('relatoriosDesc');

  catalogo.style.display = tipo === 'catalogo' ? 'block' : 'none';
  visaoGeral.style.display = tipo === 'visao-geral' ? 'block' : 'none';
  contratos.style.display = tipo === 'contratos' ? 'block' : 'none';
  btnVoltar.style.display = tipo === 'catalogo' ? 'none' : 'inline-flex';
  acoesVisaoGeral.style.display = tipo === 'visao-geral' ? 'flex' : 'none';
  acoesContratos.style.display = tipo === 'contratos' ? 'flex' : 'none';

  if (tipo === 'visao-geral') {
    titulo.textContent = 'Faturamento & Pipeline Comercial';
    desc.textContent = 'Análises atualizadas do Protheus e Bitrix, reunidas em uma única visão de consulta.';
    carregarRelatorios();
  } else if (tipo === 'contratos') {
    titulo.textContent = 'Gestão de Contratos Ativos (180 dias)';
    desc.textContent = 'Carteira ativa e em assinatura puxada do Bitrix em tempo real, com semáforo de vencimento e renovação.';
    carregarContratos();
  } else {
    titulo.textContent = 'Central de Relatórios';
    desc.textContent = 'Escolha um painel corporativo conectado em tempo real ao Bitrix e ao Protheus.';
  }
}

function configurarControlesRelatorios() {
  const selectAno = document.getElementById('relatoriosAno');
  const anoAtual = new Date().getFullYear();
  for (let ano = anoAtual; ano >= 2023; ano -= 1) {
    const option = document.createElement('option');
    option.value = String(ano);
    option.textContent = String(ano);
    selectAno.appendChild(option);
  }

  document.getElementById('btnAtualizarRelatorios').addEventListener('click', () => carregarRelatorios(true));
  selectAno.addEventListener('change', () => carregarRelatorios(true));

  document.getElementById('btnVoltarCatalogoRelatorios').addEventListener('click', () => abrirRelatorio('catalogo'));

  document.querySelectorAll('[data-report-trigger]').forEach(btn => {
    btn.addEventListener('click', event => {
      event.stopPropagation();
      abrirRelatorio(btn.dataset.reportTrigger);
    });
  });

  document.querySelectorAll('.report-option-card[data-report]').forEach(card => {
    card.addEventListener('click', () => abrirRelatorio(card.dataset.report));
  });

  document.getElementById('btnAtualizarContratos').addEventListener('click', () => carregarContratos(true));
  document.getElementById('btnExportarContratosCsv').addEventListener('click', exportarContratosCsv);

  document.querySelectorAll('#contratosSemaforoBar .semaphore-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#contratosSemaforoBar .semaphore-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      contratosFiltroPrazo = pill.dataset.prazo || 'todos';
      renderizarContratos();
    });
  });

  [
    'filtroContratoBusca',
    'filtroContratoUnidade',
    'filtroContratoConsultor',
    'filtroContratoEtapa',
    'filtroContratoTipo',
    'filtroOcultarSpot'
  ].forEach(id => {
    const el = document.getElementById(id);
    const evt = el.tagName === 'INPUT' && el.type === 'text' ? 'input' : 'change';
    el.addEventListener(evt, renderizarContratos);
  });

  document.getElementById('btnLimparFiltrosContratos').addEventListener('click', () => {
    document.getElementById('filtroContratoBusca').value = '';
    document.getElementById('filtroContratoUnidade').value = '';
    document.getElementById('filtroContratoConsultor').value = '';
    document.getElementById('filtroContratoEtapa').value = '';
    document.getElementById('filtroContratoTipo').value = '';
    document.getElementById('filtroOcultarSpot').checked = false;
    contratosFiltroPrazo = 'todos';
    document.querySelectorAll('#contratosSemaforoBar .semaphore-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.prazo === 'todos');
    });
    renderizarContratos();
  });
}

function formatarMoeda(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1
  }).format(Number(valor || 0));
}

function formatarMoedaCompleta(valor) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'BRL', maximumFractionDigits: 0
  }).format(Number(valor || 0));
}

function escaparHtml(valor) {
  return String(valor ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  }[char]));
}

function renderizarRanking(id, itens, titulo, descricao = null) {
  const container = document.getElementById(id);
  const maiorValor = Math.max(...itens.map(item => Number(item.valor || 0)), 1);

  if (!itens.length) {
    container.innerHTML = '<p class="report-empty-list">Sem dados para o período.</p>';
    return;
  }

  container.innerHTML = itens.map((item, indice) => {
    const percentual = Math.max(3, (Number(item.valor || 0) / maiorValor) * 100);
    const rotulo = item[titulo] || 'Não identificado';
    const complemento = descricao ? descricao(item) : '';
    return `
      <div class="report-ranking-row">
        <span class="report-ranking-position">${String(indice + 1).padStart(2, '0')}</span>
        <div class="report-ranking-main">
          <div class="report-ranking-label" title="${escaparHtml(rotulo)}">${escaparHtml(rotulo)}</div>
          ${complemento ? `<div class="report-ranking-detail">${escaparHtml(complemento)}</div>` : ''}
          <div class="report-ranking-track"><span style="width:${percentual}%"></span></div>
        </div>
        <strong>${formatarMoeda(item.valor)}</strong>
      </div>`;
  }).join('');
}

function renderizarGraficoMensal(itens) {
  const container = document.getElementById('graficoFaturamentoMensal');
  const maiorValor = Math.max(...itens.map(item => Number(item.valor || 0)), 1);
  const nomesMes = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

  container.innerHTML = itens.map(item => {
    const mes = Number(String(item.mes).slice(-2));
    const altura = Math.max(5, (Number(item.valor || 0) / maiorValor) * 100);
    return `<div class="monthly-chart-item" title="${nomesMes[mes - 1]}: ${formatarMoedaCompleta(item.valor)}">
      <span class="monthly-chart-value">${formatarMoeda(item.valor)}</span>
      <div class="monthly-chart-bar"><span style="height:${altura}%"></span></div>
      <small>${nomesMes[mes - 1]}</small>
    </div>`;
  }).join('');
}

async function fetchRelatorioAutenticado(url) {
  let token = '';
  if (sbClient && sbClient.auth) {
    const { data } = await sbClient.auth.getSession();
    token = data?.session?.access_token || '';
  }

  if (!token) {
    throw new Error('Sessão não autenticada no servidor. Clique em "Sair" e entre novamente (ou use "Esqueci minha senha" para sincronizar sua conta).');
  }

  const resposta = await fetch(url, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` }
  });
  const dados = await resposta.json();
  if (!resposta.ok || !dados.ok) {
    throw new Error(dados.error || 'Falha ao consultar os dados.');
  }
  return dados;
}

async function carregarRelatorios(forcar = false) {
  if (!isAdminMaster(currentUser?.email) || (relatoriosCarregados && !forcar)) return;

  const carregando = document.getElementById('relatoriosLoading');
  const conteudo = document.getElementById('relatoriosConteudo');
  const erro = document.getElementById('relatoriosErro');
  const botao = document.getElementById('btnAtualizarRelatorios');
  const ano = document.getElementById('relatoriosAno').value;

  carregando.style.display = 'flex';
  conteudo.style.display = 'none';
  erro.style.display = 'none';
  botao.disabled = true;

  try {
    const dados = await fetchRelatorioAutenticado(`/api/relatorios?year=${encodeURIComponent(ano)}`);

    document.getElementById('kpiFaturamentoLiquido').textContent = formatarMoeda(dados.resumo.liquido);
    document.getElementById('kpiFaturamentoBruto').textContent = formatarMoeda(dados.resumo.bruto);
    document.getElementById('kpiPipeline').textContent = formatarMoeda(dados.resumo.pipeline);
    document.getElementById('kpiPipelineDetalhe').textContent = `${dados.resumo.negociosPipeline} negócios em aberto no Bitrix`;
    document.getElementById('kpiExpurgos').textContent = formatarMoeda(dados.resumo.expurgos);

    const protheusAtualizado = dados.atualizacao?.protheus
      ? new Date(dados.atualizacao.protheus).toLocaleDateString('pt-BR')
      : 'sem data';
    document.getElementById('relatoriosAtualizadoEm').textContent = `Protheus atualizado até ${protheusAtualizado}`;

    renderizarGraficoMensal(dados.mensal);
    renderizarRanking('listaUnidades', dados.unidades, 'unidade');
    renderizarRanking('listaContratos', dados.contratos, 'contrato', item => item.cliente);
    renderizarRanking('listaEquipamentos', dados.equipamentos, 'equipamento');
    renderizarRanking('listaConsultores', dados.consultores, 'consultor');
    renderizarRanking('listaPipeline', dados.pipeline, 'consultor', item => `${item.negocios} negócios em aberto`);

    relatoriosCarregados = true;
    conteudo.style.display = 'block';
  } catch (ex) {
    erro.innerHTML = `<i class="ph ph-warning-circle"></i><span>${escaparHtml(ex.message || 'Não foi possível atualizar os relatórios.')}</span>`;
    erro.style.display = 'flex';
  } finally {
    carregando.style.display = 'none';
    botao.disabled = false;
  }
}

function formatarDataBr(isoDate) {
  if (!isoDate) return '—';
  const [ano, mes, dia] = String(isoDate).slice(0, 10).split('-');
  if (!ano || !mes || !dia) return '—';
  return `${dia}/${mes}/${ano}`;
}

function preencherSelectFiltro(selectId, opcoes, rotuloPadrao) {
  const select = document.getElementById(selectId);
  const valorAtual = select.value;
  select.innerHTML = `<option value="">${escaparHtml(rotuloPadrao)}</option>` +
    opcoes.map(op => `<option value="${escaparHtml(op)}">${escaparHtml(op)}</option>`).join('');
  if (opcoes.includes(valorAtual)) select.value = valorAtual;
}

function obterContratosFiltrados(ignorarPrazo = false) {
  const lista = contratosPayload?.contratos || [];
  const busca = document.getElementById('filtroContratoBusca').value.trim().toLowerCase();
  const unidade = document.getElementById('filtroContratoUnidade').value;
  const consultor = document.getElementById('filtroContratoConsultor').value;
  const etapa = document.getElementById('filtroContratoEtapa').value;
  const tipo = document.getElementById('filtroContratoTipo').value;
  const ocultarSpot = document.getElementById('filtroOcultarSpot').checked;

  return lista.filter(item => {
    if (ocultarSpot && item.tipoContrato === 'Contrato Spot') return false;
    if (unidade) {
      const unidadesItem = String(item.unidade || '').split(',').map(u => u.trim());
      if (!unidadesItem.includes(unidade)) return false;
    }
    if (consultor && item.consultor !== consultor) return false;
    if (etapa && item.etapa !== etapa) return false;
    if (tipo && item.tipoContrato !== tipo) return false;

    if (busca) {
      const texto = `${item.id} ${item.cliente} ${item.titulo} ${item.equipamentos} ${item.consultor} ${item.unidade}`.toLowerCase();
      if (!texto.includes(busca)) return false;
    }

    if (!ignorarPrazo && contratosFiltroPrazo !== 'todos') {
      if (contratosFiltroPrazo === '180d') {
        return ['critico_30', 'alerta_90', 'atencao_180'].includes(item.statusPrazo);
      }
      return item.statusPrazo === contratosFiltroPrazo;
    }
    return true;
  });
}

function badgeFaltamContrato(item) {
  const d = item.faltamDias;
  if (item.statusPrazo === 'sem_data' || d === null) {
    return '<span class="contract-badge badge-semdata">Sem data fim</span>';
  }
  if (item.statusPrazo === 'vencido') {
    return `<span class="contract-badge badge-vencido">Vencido há ${Math.abs(d)}d</span>`;
  }
  if (item.statusPrazo === 'critico_30') {
    return `<span class="contract-badge badge-critico">${d === 0 ? 'Vence hoje' : `Faltam ${d}d`}</span>`;
  }
  if (item.statusPrazo === 'alerta_90') {
    return `<span class="contract-badge badge-alerta">Faltam ${d}d</span>`;
  }
  if (item.statusPrazo === 'atencao_180') {
    return `<span class="contract-badge badge-atencao">Faltam ${d}d</span>`;
  }
  return `<span class="contract-badge badge-vigente">Faltam ${d}d</span>`;
}

function renderizarContratos() {
  if (!contratosPayload) return;

  const baseSemPrazo = obterContratosFiltrados(true);
  const filtrados = obterContratosFiltrados(false);

  const contadores = {
    todos: baseSemPrazo.length,
    em180: 0,
    critico_30: 0,
    alerta_90: 0,
    atencao_180: 0,
    vigente: 0,
    vencido: 0,
    sem_data: 0
  };

  for (const item of baseSemPrazo) {
    contadores[item.statusPrazo] = (contadores[item.statusPrazo] || 0) + 1;
    if (['critico_30', 'alerta_90', 'atencao_180'].includes(item.statusPrazo)) contadores.em180 += 1;
  }

  document.getElementById('pillCountTodos').textContent = contadores.todos;
  document.getElementById('pillCount180').textContent = contadores.em180;
  document.getElementById('pillCountCritico').textContent = contadores.critico_30;
  document.getElementById('pillCountAlerta').textContent = contadores.alerta_90;
  document.getElementById('pillCountAtencao').textContent = contadores.atencao_180;
  document.getElementById('pillCountVigente').textContent = contadores.vigente;
  document.getElementById('pillCountVencido').textContent = contadores.vencido;
  document.getElementById('pillCountSemData').textContent = contadores.sem_data;

  const valorFiltro = filtrados.reduce((acc, item) => acc + Number(item.valor || 0), 0);
  const em180Filtrados = filtrados.filter(i => ['critico_30', 'alerta_90', 'atencao_180'].includes(i.statusPrazo));
  const valor180 = em180Filtrados.reduce((acc, item) => acc + Number(item.valor || 0), 0);
  const criticoCount = filtrados.filter(i => i.statusPrazo === 'critico_30').length;
  const alertaCount = filtrados.filter(i => i.statusPrazo === 'alerta_90').length;
  const atencaoCount = filtrados.filter(i => i.statusPrazo === 'atencao_180').length;
  const assinaturaCount = filtrados.filter(i => i.assinaturaPendente).length;
  const semDataCount = filtrados.filter(i => i.statusPrazo === 'sem_data').length;
  const vencidoCount = filtrados.filter(i => i.statusPrazo === 'vencido').length;

  document.getElementById('kpiContratosTotal').textContent = String(filtrados.length);
  document.getElementById('kpiContratosValorTotal').textContent = `Valor total: ${formatarMoeda(valorFiltro)}`;
  document.getElementById('kpiContratos180').textContent = String(em180Filtrados.length);
  document.getElementById('kpiContratosValor180').textContent = `Exposição: ${formatarMoeda(valor180)}`;
  document.getElementById('kpiContratosCritico').textContent = String(criticoCount);
  document.getElementById('kpiContratosAlertaDetalhe').textContent = `Alerta 31–90d: ${alertaCount} · Atenção 91–180d: ${atencaoCount}`;
  document.getElementById('kpiContratosAssinatura').textContent = String(assinaturaCount);
  document.getElementById('kpiContratosSemData').textContent = String(semDataCount);
  document.getElementById('kpiContratosVencidosDetalhe').textContent = `Vencidos (sem baixa/aditivo): ${vencidoCount}`;

  document.getElementById('contratosResumoTabela').textContent =
    `Exibindo ${filtrados.length} de ${contratosPayload.contratos.length} negócios no Bitrix`;

  const tbody = document.getElementById('tbodyContratos');
  if (!filtrados.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="contracts-empty-row">Nenhum contrato encontrado com os filtros aplicados.</td></tr>';
    return;
  }

  tbody.innerHTML = filtrados.map(item => {
    const cardCell = item.bitrixUrl
      ? `<a href="${escaparHtml(item.bitrixUrl)}" target="_blank" rel="noopener" class="contract-card-link">#${escaparHtml(item.id)} <i class="ph ph-arrow-square-out"></i></a>`
      : `<span class="contract-card-id">#${escaparHtml(item.id)}</span>`;

    const eqTexto = item.equipamentos || 'Não especificado no card';
    const etapaClass = item.assinaturaPendente ? 'stage-pending' : 'stage-active';
    const vigenciaTexto = `${formatarDataBr(item.dataInicio)} → ${formatarDataBr(item.dataFim)}`;

    return `
      <tr>
        <td>${cardCell}</td>
        <td>
          <div class="contract-client">${escaparHtml(item.cliente)}</div>
          <div class="contract-title" title="${escaparHtml(item.titulo)}">${escaparHtml(item.titulo)}</div>
        </td>
        <td><span class="contract-unit-tag">${escaparHtml(item.unidade)}</span></td>
        <td>${escaparHtml(item.consultor)}</td>
        <td>
          <span class="contract-stage-pill ${etapaClass}">${escaparHtml(item.etapa)}</span>
          <div class="contract-type-sub">${escaparHtml(item.tipoContrato)}</div>
        </td>
        <td><div class="contract-equip" title="${escaparHtml(eqTexto)}">${escaparHtml(eqTexto)}</div></td>
        <td class="contract-dates">${escaparHtml(vigenciaTexto)}</td>
        <td>${badgeFaltamContrato(item)}</td>
        <td style="text-align: right;" class="contract-value">${formatarMoedaCompleta(item.valor)}</td>
      </tr>
    `;
  }).join('');
}

async function carregarContratos(forcar = false) {
  if (!isAdminMaster(currentUser?.email) || (contratosCarregados && !forcar)) return;

  const carregando = document.getElementById('contratosLoading');
  const conteudo = document.getElementById('contratosConteudo');
  const erro = document.getElementById('contratosErro');
  const botao = document.getElementById('btnAtualizarContratos');

  carregando.style.display = 'flex';
  conteudo.style.display = 'none';
  erro.style.display = 'none';
  botao.disabled = true;

  try {
    const dados = await fetchRelatorioAutenticado('/api/contratos');

    contratosPayload = dados;
    contratosCarregados = true;

    const bitrixAtualizado = dados.atualizacao?.bitrix
      ? new Date(dados.atualizacao.bitrix).toLocaleString('pt-BR')
      : 'sem data';
    document.getElementById('contratosAtualizadoEm').textContent = `Bitrix atualizado em ${bitrixAtualizado}`;

    preencherSelectFiltro('filtroContratoUnidade', dados.filtros?.unidades || [], 'Todas as unidades');
    preencherSelectFiltro('filtroContratoConsultor', dados.filtros?.consultores || [], 'Todos os executivos');
    preencherSelectFiltro('filtroContratoEtapa', dados.filtros?.etapas || [], 'Todas as etapas');
    preencherSelectFiltro('filtroContratoTipo', dados.filtros?.tipos || [], 'Todos os tipos');

    renderizarContratos();
    conteudo.style.display = 'block';
  } catch (ex) {
    erro.innerHTML = `<i class="ph ph-warning-circle"></i><span>${escaparHtml(ex.message || 'Não foi possível carregar os contratos do Bitrix.')}</span>`;
    erro.style.display = 'flex';
  } finally {
    carregando.style.display = 'none';
    botao.disabled = false;
  }
}

function exportarContratosCsv() {
  if (!contratosPayload) {
    showToast('Carregue os contratos antes de exportar.', 'warning');
    return;
  }
  const filtrados = obterContratosFiltrados(false);
  if (!filtrados.length) {
    showToast('Nenhum contrato visível no filtro para exportar.', 'warning');
    return;
  }

  const cabecalho = [
    'Card Bitrix', 'Cliente', 'Negocio', 'Unidade', 'Executivo',
    'Etapa', 'Tipo Contrato', 'Equipamentos', 'Inicio', 'Fim',
    'Faltam (dias)', 'Status Prazo', 'Valor'
  ];

  const escaparCsv = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = filtrados.map(item => [
    item.id,
    item.cliente,
    item.titulo,
    item.unidade,
    item.consultor,
    item.etapa,
    item.tipoContrato,
    item.equipamentos,
    formatarDataBr(item.dataInicio),
    formatarDataBr(item.dataFim),
    item.faltamDias === null ? '' : item.faltamDias,
    item.statusPrazo,
    Number(item.valor || 0).toFixed(2).replace('.', ',')
  ].map(escaparCsv).join(';'));

  const csv = '\uFEFF' + [cabecalho.map(escaparCsv).join(';'), ...linhas].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Contratos_Ativos_Bitrix_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
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
      const { data: updatedAuthUser, error } = await sbClient.auth.updateUser({ password: novaSenha });
      if (error) {
        erroBox.textContent = 'Falha ao atualizar senha: ' + error.message;
        erroBox.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Salvar Nova Senha';
        return;
      }
      if (updatedAuthUser && updatedAuthUser.user && updatedAuthUser.user.email) {
        await sbClient
          .from('usuarios_nps')
          .update({ senha: novaSenha })
          .ilike('email', updatedAuthUser.user.email);
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

async function handleSalvarPrimeiroAcesso(e) {
  e.preventDefault();
  const novaSenha = document.getElementById('inputPrimeiroAcessoNovaSenha').value.trim();
  const confirmaSenha = document.getElementById('inputPrimeiroAcessoConfirma').value.trim();
  const erroBox = document.getElementById('erroPrimeiroAcesso');
  const btn = document.getElementById('btnSalvarPrimeiroAcesso');

  if (erroBox) erroBox.style.display = 'none';

  if (!novaSenha || novaSenha.length < 6) {
    if (erroBox) {
      erroBox.textContent = 'A nova senha deve ter no mínimo 6 caracteres.';
      erroBox.style.display = 'block';
    }
    return;
  }

  if (novaSenha === 'Cordeiro@2026') {
    if (erroBox) {
      erroBox.textContent = 'A nova senha deve ser diferente da senha provisória padrão (Cordeiro@2026).';
      erroBox.style.display = 'block';
    }
    return;
  }

  if (novaSenha !== confirmaSenha) {
    if (erroBox) {
      erroBox.textContent = 'As senhas digitadas não coincidem. Digite com atenção.';
      erroBox.style.display = 'block';
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="ph ph-spinner-gap animate-spin"></i> <span>Salvando no banco...</span>';
  }

  try {
    if (!currentUser || !currentUser.email) {
      throw new Error('Sessão expirada. Faça login novamente.');
    }

    // 1. Atualiza na tabela oficial de usuários no Supabase (usuarios_nps)
    if (sbClient) {
      const { error: dbError } = await sbClient
        .from('usuarios_nps')
        .update({ senha: novaSenha })
        .ilike('email', currentUser.email);

      if (dbError) {
        throw new Error('Falha ao atualizar no banco: ' + dbError.message);
      }
    }

    // 2. Atualiza no Supabase Auth caso o usuário tenha sessão ativa
    if (sbClient && sbClient.auth) {
      try {
        await sbClient.auth.updateUser({ password: novaSenha });
      } catch (authEx) {
        console.warn('Aviso ao sincronizar Auth:', authEx);
      }
    }

    // 3. Atualiza os dados locais de sessão e da lista
    currentUser.senha = novaSenha;
    const uIdx = usersList.findIndex(u => u.email.toLowerCase() === currentUser.email.toLowerCase());
    if (uIdx !== -1) {
      usersList[uIdx].senha = novaSenha;
    }
    salvarUsuariosStorage();
    localStorage.setItem(STORAGE_KEY_AUTH, JSON.stringify(currentUser));

    fecharModal('modalPrimeiroAcesso');
    showToast('Senha pessoal cadastrada com sucesso! Bem-vindo ao Farol Comercial.', 'success');
    showAppScreen();
  } catch (err) {
    console.error('Erro ao salvar nova senha de primeiro acesso:', err);
    if (erroBox) {
      erroBox.textContent = err.message || 'Erro ao salvar nova senha. Tente novamente.';
      erroBox.style.display = 'block';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Salvar e Acessar';
    }
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
