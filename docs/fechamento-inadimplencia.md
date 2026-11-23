# Fechamento mensal de inadimplencia (Farol)

## Por que existe
A SE1010 guarda apenas o saldo **atual** de cada titulo. Quando o cliente paga, o saldo e reduzido ou zerado no proprio registro. Sem uma foto no dia do fechamento, nao e possivel reconstruir depois quanto estava em aberto.

Este recurso congela, no ultimo dia de cada mes, a carteira titulo a titulo. O painel passa a oferecer duas posicoes:

- **Saldo atual (Protheus)** — leitura ao vivo.
- **Fechamento &lt;mes&gt;** — foto imutavel, com regras versionadas e impacto das exclusoes.

## O que a TI precisa executar
O usuario da aplicacao **nao tem** privilegio de CREATE no DW. Rode o script abaixo como owner do schema e ajuste `:ROLE` para o papel usado pela API (hoje `weverson_feitosa`).

```sql
CREATE SCHEMA IF NOT EXISTS farol;

CREATE TABLE IF NOT EXISTS farol.inadimplencia_fechamento (
  id bigserial PRIMARY KEY,
  competencia char(7) NOT NULL UNIQUE,
  data_ref date NOT NULL,
  gerado_em timestamptz NOT NULL DEFAULT now(),
  gerado_por text NOT NULL,
  origem text NOT NULL,
  regras_versao text NOT NULL,
  regras text[] NOT NULL DEFAULT '{}',
  qtd_titulos integer NOT NULL,
  saldo_total numeric(18,2) NOT NULL,
  valor_total numeric(18,2) NOT NULL,
  impacto jsonb,
  observacao text
);

CREATE TABLE IF NOT EXISTS farol.inadimplencia_fechamento_titulo (
  id bigserial PRIMARY KEY,
  fechamento_id bigint NOT NULL REFERENCES farol.inadimplencia_fechamento(id) ON DELETE CASCADE,
  cod_filial text, serie text, titulo text, parcela text, tipo text, loja text,
  cod_cliente text, nome_cliente text, natureza text, cod_vendedor text, executivo text,
  margem text, contrato text, faixa text,
  emissao date, vencimento_real date,
  valor_original numeric(18,2), saldo numeric(18,2)
);

CREATE INDEX IF NOT EXISTS ix_inad_fech_titulo
  ON farol.inadimplencia_fechamento_titulo (fechamento_id);

GRANT USAGE ON SCHEMA farol TO :ROLE;
GRANT SELECT, INSERT, DELETE ON farol.inadimplencia_fechamento TO :ROLE;
GRANT SELECT, INSERT, DELETE ON farol.inadimplencia_fechamento_titulo TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE farol.inadimplencia_fechamento_id_seq TO :ROLE;
GRANT USAGE, SELECT ON SEQUENCE farol.inadimplencia_fechamento_titulo_id_seq TO :ROLE;
```

## Como funciona depois de liberado
- Cron diario as 02:55 UTC (23:55 em America/Sao_Paulo).
- No **ultimo dia do mes** ele grava o fechamento oficial daquela competencia.
- No **dia 1**, se o fechamento anterior nao existir, grava uma captura de seguranca marcada como `cron_fallback`, avisando que pode conter movimentos do dia 1.
- Tambem e possivel fechar manualmente pelo botao **Fechar competencia** no painel.
- Refazer uma competencia exige `forcar=true` e substitui a foto anterior.

## Variavel de ambiente
`CRON_SECRET` (producao) protege a rota de cron. O Vercel envia `Authorization: Bearer <CRON_SECRET>`.

## Regras aplicadas (versao 2)
| Regra | Criterio |
|---|---|
| `ra_adt` | tipo `RA`/`NCC` ou prefixo `ADT` |
| `mutuos` | prefixo `MUT` |
| `intercompany` | cliente na lista de empresas do grupo |
| `venda_ativos` | prefixo `1` |

O painel exibe quanto cada regra retirou. Vencimentos com 365 dias ou mais sao classificados como `acima_365` (perda), e nao entram na visao padrao de 365 dias.

Retencoes (`IS-`, `IN-`) entram negativas, como na planilha de conferencia.

## Pendencias de conciliacao
As exclusoes manuais por cliente (T&A, Eneva e outros) ainda **nao** estao codificadas. Enquanto isso, o saldo do painel sera maior que o da planilha do financeiro.
