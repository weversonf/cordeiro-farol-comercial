"""
Importa (e gera na primeira execução) a planilha editável oficial da RMR:
  data/RMR_Base_Oficial_Editavel.xlsx -> data/rmr-base-oficial.json

Uso:
  python scripts/import-rmr-base.py          # importa a planilha para JSON
  python scripts/import-rmr-base.py --init   # cria/recria a planilha modelo preenchida e importa
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
from openpyxl.styles import Alignment, Font, PatternFill

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_XLSX = BASE_DIR / "data" / "RMR_Base_Oficial_Editavel.xlsx"
OUT_JSON = BASE_DIR / "data" / "rmr-base-oficial.json"


def clean_str(val) -> str:
    if val is None:
        return ""
    return re.sub(r"\s+", " ", str(val).replace("\r", " ").replace("\n", " ")).strip()


def to_num(val) -> float | None:
    if val is None or str(val).strip() == "":
        return None
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip().replace("R$", "").replace(" ", "")
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def to_int(val) -> int | None:
    n = to_num(val)
    return int(round(n)) if n is not None else None


def to_bool(val) -> bool:
    s = clean_str(val).lower()
    return s in {"1", "sim", "s", "true", "yes", "x", "*"}


def create_initial_workbook(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    wb = openpyxl.Workbook()

    header_fill = PatternFill(start_color="0F2942", end_color="0F2942", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    body_font = Font(name="Calibri", size=10)
    money_fmt = "#,##0.00"

    def style_sheet(ws, headers, rows, col_widths, money_cols):
        ws.append(headers)
        for col_idx in range(1, len(headers) + 1):
            c = ws.cell(row=1, column=col_idx)
            c.fill = header_fill
            c.font = header_font
            c.alignment = Alignment(horizontal="center", vertical="center")
        for r in rows:
            ws.append(r)
        for r_idx in range(2, len(rows) + 2):
            for c_idx in range(1, len(headers) + 1):
                c = ws.cell(row=r_idx, column=c_idx)
                c.font = body_font
                if c_idx in money_cols and c.value is not None:
                    c.number_format = money_fmt
        for idx, w in enumerate(col_widths, start=1):
            ws.column_dimensions[openpyxl.utils.get_column_letter(idx)].width = w
        ws.freeze_panes = "A2"

    # 1. METAS_EXECUTIVOS (Regra da folha oficial 2º Semestre Jul-Dez/2026)
    # - Cristiano = 100% Norte | Bruno = 100% Wind
    # - Fernando = 50% (Complexo + Pecém) | Fabrício = 50% (Complexo + Pecém)
    # - Cristiane / Thiago = meta Spot editável (Out/26 = Base Auditoria Premiação)
    metas_2sem_unidades = {
        7:  {"Complexo": 1941352.00, "Engenharia": 5275119.00, "Norte": 1477451.00, "Pecém": 2679779.00, "Transportes": 183128.00, "Wind": 4243907.00},
        8:  {"Complexo": 1040598.00, "Engenharia": 3106540.00, "Norte": 2402345.00, "Pecém": 1204495.00, "Transportes": 712385.00, "Wind": 4088881.00},
        9:  {"Complexo": 2447645.00, "Engenharia": 4967048.00, "Norte": 3486170.00, "Pecém": 3464932.00, "Transportes": 0.00,      "Wind": 5826224.00},
        10: {"Complexo": 3224047.00, "Engenharia": 4740292.00, "Norte": 1669170.00, "Pecém": 3407077.00, "Transportes": 0.00,      "Wind": 5826224.00},
        11: {"Complexo": 3189458.00, "Engenharia": 5896148.00, "Norte": 3559170.00, "Pecém": 3476045.00, "Transportes": 0.00,      "Wind": 5826224.00},
        12: {"Complexo": 2954458.00, "Engenharia": 4628117.00, "Norte": 2944500.00, "Pecém": 3195077.00, "Transportes": 0.00,      "Wind": 5826224.00},
    }

    ws_exec = wb.active
    ws_exec.title = "METAS_EXECUTIVOS"
    exec_headers = [
        "ano", "mes", "cod_vendedor", "executivo", "unidade_ref", "meta_mensal", "observacao"
    ]
    exec_rows = []
    for mes_num, u_map in metas_2sem_unidades.items():
        half_cp = round((u_map["Complexo"] + u_map["Pecém"]) / 2.0, 2)
        exec_rows.extend([
            [2026, mes_num, "000056", "Cristiano Assis", "Norte", u_map["Norte"], "100% Meta Norte (Folha 2º Sem)"],
            [2026, mes_num, "000036", "Bruno Pessoa", "Wind", u_map["Wind"], "100% Meta Wind (Folha 2º Sem)"],
            [2026, mes_num, "000057", "Fernando Oliveira", "Complexo + Pecém (50%)", half_cp, "50% (Complexo + Pecém) (Folha 2º Sem)"],
            [2026, mes_num, "000058", "Fabrício Medeiros", "Complexo + Pecém (50%)", half_cp, "50% (Complexo + Pecém) (Folha 2º Sem)"],
            [2026, mes_num, "0050", "Cristiane Lúcio", "Spot / Inbound", 403840.38, "Base Auditoria Out/26 vinculada (Jul-Dez)"],
            [2026, mes_num, "000054", "Thiago do Nascimento", "Spot / Pecém", 403840.38 if mes_num >= 10 else 0.00, "Base Auditoria Out/26 (editável)"],
        ])
    style_sheet(ws_exec, exec_headers, exec_rows, [8, 8, 16, 26, 26, 18, 50], {6})

    # 2. UNIDADES_RMR (Revisão Agosto/26 + Distribuição 2º Semestre Jul-Dez/26 + Fechamento Out/26)
    ws_unid = wb.create_sheet("UNIDADES_RMR")
    unid_headers = [
        "ano", "mes", "unidade", "meta_mes", "realizado_oficial",
        "backlog_contratado", "realizado_ytd_oficial", "realizado_s2_oficial",
        "meta_anual_oficial", "observacao"
    ]
    meta_anual_rev_ago = {
        "Complexo": 19166139.00,
        "Engenharia": 40000001.00,
        "Norte": 31076976.00,
        "Pecém": 26625813.00,
        "Transportes": 3992492.00,
        "Wind": 60000000.00,
    }
    fechamento_out_26 = {
        "Complexo":    (1383414.00, 9824846.00,  5456265.00),
        "Norte":       (1888970.00, 23429019.00, 7890849.00),
        "Pecém":       (1147309.00, 17438007.00, 8239599.00),
        "Transportes": (0.00,       3280107.00,  183128.00),
        "Wind":        (316309.00,  39828002.00, 11465686.00),
        "Engenharia":  (931443.00,  21582934.00, 10196197.00),
    }
    backlog_nov_dez = {
        11: {"Complexo": 1032024.00, "Norte": 808170.00, "Pecém": 1267083.00, "Transportes": 0.00, "Wind": 4326341.00, "Engenharia": 1758518.00},
        12: {"Complexo": 1066088.00, "Norte": 1705000.00, "Pecém": 1674481.00, "Transportes": 0.00, "Wind": 4440153.00, "Engenharia": 1552285.00},
    }
    unid_rows = []
    for mes_num, u_map in metas_2sem_unidades.items():
        for unid in ["Complexo", "Norte", "Pecém", "Transportes", "Wind", "Engenharia"]:
            real_mes = real_ytd = real_s2 = bl = None
            obs = "Distribuição 2º Sem + Revisão Ago/26 (Folha Metas)"
            if mes_num == 10:
                real_mes, real_ytd, real_s2 = fechamento_out_26[unid]
                obs = "Meta Folha 2º Sem + Fechamento Oficial Out/26 (PPTX Slide 4)"
            elif mes_num in (11, 12):
                bl = backlog_nov_dez[mes_num][unid]
                obs = "Meta Folha 2º Sem + Backlog Contratado (PPTX Slide 4)"
            unid_rows.append([
                2026, mes_num, unid, u_map[unid], real_mes, bl,
                real_ytd, real_s2, meta_anual_rev_ago[unid], obs
            ])
    style_sheet(ws_unid, unid_headers, unid_rows, [8, 8, 16, 16, 18, 20, 22, 22, 20, 52], {4, 5, 6, 7, 8, 9})

    # 3. MEDICOES_PENDENTES
    ws_med = wb.create_sheet("MEDICOES_PENDENTES")
    med_headers = [
        "competencia", "modalidade", "cliente", "unidade", "valor", "aguardando_pedido", "observacao"
    ]
    med_rows = [
        ["2026-10", "Spot", "SIEMENS GAMESA", "Wind", 226990.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "VLI (SBV9G48)", "Pecém", 123475.00, "Sim", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "VLI (OCZ2824)", "Pecém", 115615.00, "Sim", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "VALE - S11D", "Norte", 112889.00, "Sim", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "VLI (67679)", "Pecém", 102450.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "VLI (RIL4I61)", "Pecém", 85728.00, "Sim", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "TRANSNORDESTINA", "Complexo", 73540.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Spot", "WHITE MARTINS (69323)", "Pecém", 69428.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "HEATING E COOLING", "Pecém", 65000.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "C B H (AFONSO)", "Pecém", 49620.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "MILPLAN", "Norte", 47925.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "VLI (RBH4A92)", "Pecém", 43758.00, "Sim", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "ELASTRI", "Pecém", 38977.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Spot", "WHITE MARTINS (69323)", "Pecém", 37942.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "VLI (SBE0F35)", "Pecém", 30426.00, "Sim", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Spot", "WHITE MARTINS (69233)", "Pecém", 20400.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Spot", "WHITE MARTINS (69323)", "Pecém", 16174.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Spot", "WHITE MARTINS (69323)", "Pecém", 16174.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Spot", "WHITE MARTINS (69233)", "Pecém", 15993.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Spot", "CONSORCIO MARQUISE", "Pecém", 11500.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "VLI (KOQ7F02)", "Pecém", 8161.00, "Sim", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "TEMON", "Complexo", 7600.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Spot", "WHITE MARTINS (69793)", "Pecém", 7122.00, "Não", "Fechamento Out/26 (Slide 3)"],
        ["2026-10", "Contrato", "VLI", "Complexo", 1580.00, "Não", "Fechamento Out/26 (Slide 3)"],
    ]
    style_sheet(ws_med, med_headers, med_rows, [14, 14, 28, 16, 16, 20, 34], {5})

    # 4. LEIA-ME
    ws_help = wb.create_sheet("LEIA-ME")
    help_rows = [
        ["PLANILHA OFICIAL EDITÁVEL DA RMR — FAROL CORDEIRO COMERCIAL", ""],
        ["Como editar e publicar no painel:", ""],
        ["1. METAS_EXECUTIVOS", "Edite ou adicione as metas mensais (meta_mensal) por ano, mes e cod_vendedor."],
        ["2. UNIDADES_RMR", "Deixe realizado_oficial em branco no mês em aberto (painel lê ao vivo do DW). Preencha quando o mês fechar."],
        ["3. backlog_contratado", "Informe o backlog previsto por unidade nos meses futuros (Nov, Dez, etc.)."],
        ["4. MEDICOES_PENDENTES", "Atualize as medições pendentes por competência (YYYY-MM) caso ainda não estejam no DW."],
        ["5. Aplicar alterações", "Salve a planilha e execute: python scripts/import-rmr-base.py"],
        ["6. Conferência", "Execute: node scripts/auditar-rmr.mjs --year 2026 --month 10"],
    ]
    style_sheet(ws_help, ["Item", "Instrução"], help_rows, [32, 90], set())

    wb.save(path)


def read_sheet_dicts(wb, sheet_name: str) -> list[dict]:
    if sheet_name not in wb.sheetnames:
        return []
    ws = wb[sheet_name]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []
    headers = [clean_str(h).lower() for h in rows[0]]
    out = []
    for raw in rows[1:]:
        if not any(v is not None and str(v).strip() != "" for v in raw):
            continue
        item = {}
        for idx, h in enumerate(headers):
            if h:
                item[h] = raw[idx] if idx < len(raw) else None
        out.append(item)
    return out


def import_workbook(xlsx_path: Path, json_path: Path) -> dict:
    wb = openpyxl.load_workbook(xlsx_path, data_only=True, read_only=True)

    metas_exec = []
    for r in read_sheet_dicts(wb, "METAS_EXECUTIVOS"):
        ano = to_int(r.get("ano"))
        mes = to_int(r.get("mes"))
        cod = clean_str(r.get("cod_vendedor"))
        meta = to_num(r.get("meta_mensal"))
        if not ano or not mes or not cod or meta is None:
            continue
        metas_exec.append({
            "ano": ano,
            "mes": mes,
            "mesIso": f"{ano}-{mes:02d}",
            "codVendedor": cod,
            "executivo": clean_str(r.get("executivo")),
            "unidadeRef": clean_str(r.get("unidade_ref")) or "—",
            "metaMensal": round(meta, 2),
            "observacao": clean_str(r.get("observacao")),
        })

    unidades_rmr = []
    for r in read_sheet_dicts(wb, "UNIDADES_RMR"):
        ano = to_int(r.get("ano"))
        mes = to_int(r.get("mes"))
        unidade = clean_str(r.get("unidade"))
        if not ano or not mes or not unidade:
            continue
        unidades_rmr.append({
            "ano": ano,
            "mes": mes,
            "mesIso": f"{ano}-{mes:02d}",
            "unidade": unidade,
            "metaMes": to_num(r.get("meta_mes")),
            "realizadoOficial": to_num(r.get("realizado_oficial")),
            "backlogContratado": to_num(r.get("backlog_contratado")),
            "realizadoYtdOficial": to_num(r.get("realizado_ytd_oficial")),
            "realizadoS2Oficial": to_num(r.get("realizado_s2_oficial")),
            "metaAnualOficial": to_num(r.get("meta_anual_oficial")),
            "observacao": clean_str(r.get("observacao")),
        })

    medicoes = []
    for r in read_sheet_dicts(wb, "MEDICOES_PENDENTES"):
        comp = clean_str(r.get("competencia"))
        cliente = clean_str(r.get("cliente"))
        val = to_num(r.get("valor"))
        if not comp or not cliente or val is None:
            continue
        medicoes.append({
            "competencia": comp,
            "modalidade": clean_str(r.get("modalidade")) or "Contrato",
            "cliente": cliente,
            "unidade": clean_str(r.get("unidade")) or "—",
            "executivo": clean_str(r.get("executivo")) or None,
            "codVendedor": clean_str(r.get("cod_vendedor")) or None,
            "valor": round(val, 2),
            "aguardandoPedido": to_bool(r.get("aguardando_pedido")),
            "observacao": clean_str(r.get("observacao")),
        })

    wb.close()

    payload = {
        "fonte": xlsx_path.name,
        "atualizadoEm": datetime.now(timezone.utc).isoformat(),
        "metasExecutivos": metas_exec,
        "unidadesRmr": unidades_rmr,
        "medicoesPendentes": medicoes,
    }
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def main():
    init_flag = "--init" in sys.argv
    if init_flag or not DEFAULT_XLSX.exists():
        create_initial_workbook(DEFAULT_XLSX)
        print(f"Planilha criada em: {DEFAULT_XLSX}")

    payload = import_workbook(DEFAULT_XLSX, OUT_JSON)
    print(f"JSON atualizado em: {OUT_JSON}")
    print(f"  - Metas executivos: {len(payload['metasExecutivos'])} linhas")
    print(f"  - Unidades RMR: {len(payload['unidadesRmr'])} linhas")
    print(f"  - Medições pendentes: {len(payload['medicoesPendentes'])} linhas")


if __name__ == "__main__":
    main()
