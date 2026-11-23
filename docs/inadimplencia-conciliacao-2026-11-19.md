# Inadimplencia: atualizacao e conciliacao

## Objetivo
Consultar diretamente o Protheus e conferir o fechamento da planilha, sem importar seus valores para producao. Excluir o complemento Informakon. Criterio de aceite: conciliacao por titulo e total.

## Referencia
- Arquivo: `10 - Inadimplência Setembro 2026 + Enge.xlsx`.
- Referencia efetiva: `INDICADOR !D6`, 31/10/2026.
- Total apresentado: R$ 3.291.536,50.
- Informakon: `ENGENHARIA INFORMAKON!Q17`, R$ 17.669,80.
- Parcela Protheus: R$ 3.273.866,70, soma dos 83 registros de `DETALHAMENTO - COMERCIAL`.
- Composicao: 76 NF, 4 IS- e 3 IN-. As retencoes entram negativas.
- A soma de `BASE MES !G` com vencimento de 01/11/2025 a 31/10/2026 reproduz esse total.

## Conferencia na replica PostgreSQL
Consultas em transacao somente leitura.

As chaves completas incluindo cliente nao conciliaram. Normalizar zeros nao resolve a divergencia: os codigos de cliente da planilha diferem dos codigos na replica.

Como diagnostico, o cruzamento por filial, prefixo, numero, parcela, tipo e loja localizou univocamente 82 dos 83 registros. Esse cruzamento sem cliente NAO substitui a homologacao cadastral.

- 14 registros localizados apresentam saldo diferente da planilha.
- Soma liquida corrente dos 82 localizados: R$ 3.052.027,45.
- Diferenca para a referencia completa: R$ 221.839,25. Inclui o registro nao localizado; nao representa exclusivamente recebimentos.
- Ha tambem vencimentos alterados. Filtrar a SE1 corrente por uma data antiga nao reconstitui o fechamento.
- A busca no catalogo acessivel nao encontrou tabelas de SE5, FK1, snapshots, contas a receber ou inadimplencia que permitissem recompor movimentos historicos.

## Mudancas locais
- `api/inadimplencia.js`: retencoes negativas; parcela, loja e natureza no retorno; vinculo fiscal inclui filial; margem/contrato/vendedor ambiguos nao sao escolhidos arbitrariamente; data de vencimento inclusiva; metadados de posicao corrente.
- `assets/js/reports-extra.js`: preserva deducoes no total, janela de 365 dias, identificacao da posicao, parcela/tipo/loja no detalhe e exportacao com natureza e metodologia.
- `index.html`: filtro de faixa e rotulo explicito de saldo atual.
- Alteracoes preexistentes de `assets/js/portal.js` preservadas.

## Verificacoes
- Sintaxe Node das duas rotinas: aprovada.
- SQL executado na replica: 1.302 registros para vencimentos ate 31/10/2026 no escopo amplo; chaves unicas e sinais de retencao verificados.
- Testes do filtro: vencimento no corte, fronteira de 365 dias, futuro excluido, retencao negativa e consolidacao liquida aprovados.
- Teste de equivalencia ao fechamento: NAO aprovado.

## Pendencias para publicar como conciliado
1. Confirmar com TI/Financeiro o mapeamento dos codigos de cliente entre exportacao e replica.
2. Localizar o registro faltante e explicar alteracoes de saldo e vencimento.
3. Disponibilizar posicao historica do Protheus ou movimentos de baixa/estorno para 31/10/2026.
4. Formalizar exclusoes comerciais por chave/cadastro: intercompany, venda de ativos, mutuos e retencoes especiais. Nao inferir exclusao pelo nome do cliente nem fixar lista de titulos da planilha.
5. Reexecutar a conciliacao por chave completa antes da publicacao.

Nenhum valor de fechamento foi fixado na API. Nenhum dado Informakon foi incorporado. Esta versao permanece local, sem deploy de producao, pois ainda nao atende ao criterio de aceite.
