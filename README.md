# Farol Cordeiro Comercial (Hub & IAM)

O **Farol Cordeiro Comercial** é a plataforma corporativa unificada para acompanhamento integrado de operações, satisfação de clientes e pipeline de vendas do Grupo Cordeiro.

---

## O Conceito "Farol"

O termo **Farol** sintetiza a visão rápida e executiva da saúde comercial e operacional da empresa:
- **Temperatura e Ocupação de Frota** (Mapa de Ocupação)
- **Termômetro de Satisfação e Relacionamento** (Pesquisa NPS)
- **Pipeline e Forecast de Fechamento** (Funil de Vendas)

---

## Sistemas Integrados no Farol

1. **Mapa de Ocupação:** `https://cordeiro-mapa-ocupacao.vercel.app`
2. **Pesquisa NPS:** `https://cordeiro-nps.vercel.app`
3. **Funil de Vendas:** `https://cordeiro-funil-vendas.vercel.app`
4. **Relatórios:** visão exclusiva do Administrador Master com dados do Protheus e Bitrix.

---

## Funcionalidades Principais

- **Autenticação Unificada (SSO):** Apenas e-mails corporativos autorizados (`@cordeiroguindastes.com.br` e `@cordeiroguindastes.com`) com validação de senha.
- **Painel Farol (Launcher):** Visão rápida com badges de status de acesso e redirecionamento seguro com tickets de sessão.
- **Gestão de Perfis & Acessos (IAM):**
  - Tabela completa de colaboradores com status ativo/inativo.
  - Matriz de permissão independente para cada um dos 3 sistemas.
  - Bloqueio imediato em todas as plataformas com 1 clique (desligamento ágil e seguro).
  - Tela de login padrão corporativa com campo de senha de largura total e recuperação de senha.
- **Relatórios conectados:** faturamento por unidade, contrato, produto/equipamento e consultor (Protheus), além de pipeline por consultor (Bitrix).

## Desenvolvimento local

1. Copie `.env.example` para `.env.local` e informe as credenciais de leitura do PostgreSQL corporativo.
2. Execute `npm install` e depois `npm run dev`.
3. Acesse `http://127.0.0.1:4173`.

> As credenciais ficam somente em `.env.local`, arquivo ignorado pelo Git. Em produção, cadastre as mesmas variáveis no projeto da Vercel.

---

## Deploy Vercel

- Repositório sugerido: `weversonf/cordeiro-farol-comercial`
- Domínio sugerido: `https://cordeiro-farol.vercel.app`
- Framework: `Other / Static`
- Root / Output: `./`
