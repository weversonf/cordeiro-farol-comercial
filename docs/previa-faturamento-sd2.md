# Previa de faturamento (SD2) - Farol

## Objetivo
Entregar ao comercial uma previa de faturamento lida direto da SD2 do Protheus, aplicando as regras de expurgo da planilha de premiacao.

## Fonte
- Tabela: `stage_protheus.sd2010` (Protheus SD2, itens de nota fiscal).
- Executivo: `comercial.fato_itens_vendas` (mesma NF), por nao existir SF2 no DW.
- Unidade: 3 primeiros digitos do centro de custo (`d2_ccusto`).

## Regras aplicadas (versao 2)
| Etapa | Criterio |
|---|---|
| Escopo de receita | TES comerciais (501, 503, 511, 520, 522, 586, 620, 623, 628, 629, 630, 633, 636, 653) e CFOPs de receita |
| Unidades comerciais | Prefixos de centro de custo `413`, `414`, `415`, `416`, `417` e `423`, conforme a consulta original da premiacao v03 |
| Expurgo CM Maquinas | Prefixo de centro de custo `421` |
| Expurgo Central ADM | Prefixos de centro de custo `321`/`330` |
| Outras unidades | Demais centros de custo fora da lista comercial |
| Expurgo locacao T&A | Contrato `68673`, serie `4` |

## Resultado outubro/2026 (01 a 31/10)
| Etapa | Valor |
|---|---:|
| Faturamento SD2 bruto | R$ 28.020.710,35 |
| (-) Fora do escopo de receita | R$ 18.503.756,77 |
| (=) Receita comercial | R$ 9.516.953,58 |
| (-) CM Maquinas | R$ 1.484.923,66 |
| (-) Central ADM | R$ 1.767.092,15 |
| (-) Outras unidades | R$ 0,00 |
| (-) Locacao T&A | R$ 297.436,20 |
| (=) Faturamento comercial | R$ 5.967.501,57 |

## Validacao
- O total de receita de outubro (R$ 9.516.953,58) fica a R$ 1.446,85 do painel da premiacao (R$ 9.518.400,43), diferenca de arredondamento/corte.
- A base oficial congelada soma **R$ 5.667.444,54** no global e **R$ 5.661.544,54** nos executivos. A diferenca de R$ 5.900,00 e uma NF atribuida a Savio, fora da lista de executivos do painel.
- Contra o global congelado, a SD2 atual fica **R$ 300.057,03 acima**. A conciliacao linha a linha encontrou R$ 1.044.000,00 hoje na SD2 e ausentes no congelamento (contrato 69407), menos R$ 743.942,97 de Engenharia (filial 141401) presentes no congelamento e ausentes na SD2 atual.
- Por essa mutacao da fonte, o resultado continua rotulado como **previa** e nao como fechamento oficial.

## Arquivos
- `api/_fat_rules.js` - regras versionadas.
- `api/_fat_query.js` - consulta e agregacoes.
- `api/faturamento-sd2.js` - endpoint autenticado (`GET /api/faturamento-sd2`).
- `index.html` - card no catalogo e painel.
- `assets/js/portal.js` - rota `/relatorios/faturamento`.
- `assets/js/reports-extra.js` - carregamento, graficos e exportacao XLSX.

## Exportacao XLSX
- `BASE SD2`: itens fiscais, campos de contrato, NF, cliente, produto e classificacao.
- `POR CONTRATO`: total de cada contrato, quantidade de NFs, clientes e conciliacao dos expurgos.
- `POR NF`: uma linha por filial/NF/serie, com contrato, cliente e valores conciliados.
- `POR CLIENTE`: consolidado por codigo de cliente e loja.
- `CLIENTE X CONTRATO`: uma linha por negocio de cada cliente, com as NFs que compoem o faturamento.
- `RESUMO` e `REGRAS`: conciliacao geral e metodologia aplicada.

## Pendencias
1. Controladoria homologar se o comparativo deve usar a SD2 atual ou o congelamento da competencia.
2. Confirmar se filial `161601` (Holding) deve compor o faturamento comercial.
3. Definir se a previa deve considerar devolucoes (SD1), hoje fora do escopo.
