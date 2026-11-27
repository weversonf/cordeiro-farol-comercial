"""
Gera snapshot de fallback da Cobertura de Carteira (SPA 1100 / Planilhas Premiacao)
em data/cobertura-carteira-snapshot.json para quando BITRIX_HOOK nao estiver configurado.

Uso:
  python scripts/import-cobertura-snapshot.py
"""

from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

BASE_DIR = Path(__file__).resolve().parent.parent
COMERCIAL_DIR = BASE_DIR.parent
OUT_JSON = BASE_DIR / "data" / "cobertura-carteira-snapshot.json"

EXEC_CATALOG = [
    ("000056", "5423", "Cristiano Assis", ["CRISTIANO"]),
    ("000036", "1670", "Bruno Pessoa", ["BRUNO"]),
    ("000057", "15299", "Fernando Oliveira", ["FERNANDO"]),
    ("000058", "15257", "Fabrício Medeiros", ["FABRICIO"]),
    ("0050", "7379", "Cristiane Lúcio", ["CRISTIANE"]),
    ("059", "15413", "Marcio Funghi", ["MARCIO"]),
]


def norm(s: object) -> str:
    txt = str(s or "").strip()
    txt = unicodedata.normalize("NFD", txt)
    txt = "".join(ch for ch in txt if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", txt).upper()


def match_exec(raw: object) -> tuple[str, str, str] | None:
    n = norm(raw)
    for cod, crm_id, nome, keys in EXEC_CATALOG:
        if any(k in n for k in keys):
            return cod, crm_id, nome
    return None


def norm_ranking(raw: object) -> str:
    n = norm(raw)
    if n in {"10235", "11115", "A", "MARGEM A", "CLIENTE CHAVE A"} or n.endswith(" A"):
        return "A"
    if n in {"10233", "11117", "B", "MARGEM B", "CLIENTE CHAVE B"} or n.endswith(" B"):
        return "B"
    if n in {"10231", "11119", "C", "MARGEM C", "CLIENTE CHAVE C"} or n.endswith(" C"):
        return "C"
    return str(raw or "").strip() or "—"


def parse_sheet_novembro(xlsx_path: Path, competencia: str, label: str) -> dict:
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb["Cobertura de Carteira - Nov"]
    audit_by_key: dict[tuple[str, str], list[dict]] = {}
    if "AUDITORIA BITRIX" in wb.sheetnames:
        ws_aud = wb["AUDITORIA BITRIX"]
        for row in ws_aud.iter_rows(min_row=2, values_only=True):
            if not row or not row[0]:
                continue
            crm_id = str(row[2] or "").strip()
            dt = str(row[3] or "").strip()[:10]
            meio = str(row[5] or "").strip()
            reg = str(row[6] or "").strip()
            cli_name = reg.split("|", 1)[1].strip() if "|" in reg else reg
            audit_by_key.setdefault((crm_id, norm(cli_name)), []).append({
                "data": dt,
                "meio": meio,
                "ranking": norm_ranking(row[4]),
            })

    by_exec: dict[str, dict] = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or not row[0]:
            continue
        cliente = str(row[0] or "").strip()
        ranking = norm_ranking(row[2])
        ex = match_exec(row[3])
        if not ex or ranking not in {"A", "B"}:
            continue
        cod, crm_id, nome = ex
        status_raw = str(row[4] or "").strip()
        coberto = "FEITA" in norm(status_raw)
        meio = str(row[5] or "").strip() or None
        obs = str(row[6] or "").strip()
        m_cnt = re.search(r"(\d+)", obs)
        contatos_mes = int(m_cnt.group(1)) if m_cnt else (1 if coberto else 0)
        aud = audit_by_key.get((crm_id, norm(cliente)), [])
        datas = sorted([a["data"] for a in aud if a.get("data")])
        ultimo_contato = datas[-1] if datas else None

        bucket = by_exec.setdefault(cod, {
            "codVendedor": cod,
            "crmId": crm_id,
            "executivo": nome,
            "carteiraAB": 0,
            "carteiraA": 0,
            "carteiraB": 0,
            "cobertosDistintosAB": 0,
            "cobertosA": 0,
            "cobertosB": 0,
            "contatosValidosAB": 0,
            "clientes": [],
        })
        bucket["carteiraAB"] += 1
        if ranking == "A":
            bucket["carteiraA"] += 1
        else:
            bucket["carteiraB"] += 1
        if coberto:
            bucket["cobertosDistintosAB"] += 1
            if ranking == "A":
                bucket["cobertosA"] += 1
            else:
                bucket["cobertosB"] += 1
        bucket["contatosValidosAB"] += max(contatos_mes, len(aud))
        bucket["clientes"].append({
            "cliente": cliente,
            "segmento": str(row[1] or "").strip() or "—",
            "ranking": ranking,
            "coberto": coberto,
            "status": "Cobertura Feita" if coberto else "Pendente",
            "meioContato": meio or (aud[-1]["meio"] if aud else None),
            "dataContato": ultimo_contato,
            "contatosNoMes": max(contatos_mes, len(aud)),
            "observacao": obs or None,
        })

    wb.close()
    for b in by_exec.values():
        b["percentual"] = round((b["cobertosDistintosAB"] / b["carteiraAB"]) * 100, 2) if b["carteiraAB"] else 0.0
        b["clientes"].sort(key=lambda c: (0 if not c["coberto"] else 1, c["ranking"], c["cliente"]))
    return {
        "competencia": competencia,
        "fonte": xlsx_path.name,
        "rotulo": label,
        "executivos": by_exec,
    }


def parse_sheet_outubro(xlsx_path: Path, competencia: str, label: str) -> dict:
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb["Cobertura de Carteira - Outubro"]
    by_exec: dict[str, dict] = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or not row[0]:
            continue
        cliente = str(row[0] or "").strip()
        ranking = norm_ranking(row[2])
        ex = match_exec(row[3])
        if not ex or ranking not in {"A", "B"}:
            continue
        cod, crm_id, nome = ex
        status_raw = str(row[4] or "").strip()
        coberto = "FEITA" in norm(status_raw)
        meio = str(row[5] or "").strip() or None
        obs = str(row[6] or "").strip() or None
        bucket = by_exec.setdefault(cod, {
            "codVendedor": cod,
            "crmId": crm_id,
            "executivo": nome,
            "carteiraAB": 0,
            "carteiraA": 0,
            "carteiraB": 0,
            "cobertosDistintosAB": 0,
            "cobertosA": 0,
            "cobertosB": 0,
            "contatosValidosAB": 0,
            "clientes": [],
        })
        bucket["carteiraAB"] += 1
        if ranking == "A":
            bucket["carteiraA"] += 1
        else:
            bucket["carteiraB"] += 1
        if coberto:
            bucket["cobertosDistintosAB"] += 1
            if ranking == "A":
                bucket["cobertosA"] += 1
            else:
                bucket["cobertosB"] += 1
            bucket["contatosValidosAB"] += 1
        bucket["clientes"].append({
            "cliente": cliente,
            "segmento": str(row[1] or "").strip() or "—",
            "ranking": ranking,
            "coberto": coberto,
            "status": "Cobertura Feita" if coberto else "Pendente",
            "meioContato": meio,
            "dataContato": None,
            "contatosNoMes": 1 if coberto else 0,
            "observacao": obs,
        })

    wb.close()
    for b in by_exec.values():
        b["percentual"] = round((b["cobertosDistintosAB"] / b["carteiraAB"]) * 100, 2) if b["carteiraAB"] else 0.0
        b["clientes"].sort(key=lambda c: (0 if not c["coberto"] else 1, c["ranking"], c["cliente"]))
    return {
        "competencia": competencia,
        "fonte": xlsx_path.name,
        "rotulo": label,
        "executivos": by_exec,
    }


def main() -> None:
    competencias = {}
    out_xlsx = COMERCIAL_DIR / "02 - Premiacoes" / "2026" / "10 - Outubro 2026" / "Cobertura de Carteira - Outubro.26.xlsx"
    nov_xlsx = COMERCIAL_DIR / "02 - Premiacoes" / "2026" / "11 - Novembro 2026" / "v01 - PRELIMINAR 2026-11-24" / "Bases" / "Cobertura de Carteira - Novembro.26 (PRELIMINAR 24-11).xlsx"

    if out_xlsx.exists():
        competencias["2026-10"] = parse_sheet_outubro(out_xlsx, "2026-10", "Fechamento Outubro/2026 (Planilha Premiação)")
    if nov_xlsx.exists():
        competencias["2026-11"] = parse_sheet_novembro(nov_xlsx, "2026-11", "Preliminar Novembro/2026 (corte 24/11)")

    payload = {
        "atualizadoEm": datetime.now(timezone.utc).isoformat(),
        "criterio": "Clientes únicos Ranking A/B cobertos no SPA 1100 ÷ carteira A/B atribuída ao executivo no Bitrix24.",
        "competencias": competencias,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Snapshot gerado em {OUT_JSON}: {list(competencias.keys())}")
    for comp, info in competencias.items():
        print(f"  {comp} ({info['rotulo']}):")
        for cod, ex in sorted(info["executivos"].items()):
            print(f"    - {ex['executivo']} ({cod}): {ex['cobertosDistintosAB']}/{ex['carteiraAB']} ({ex['percentual']}%)")


if __name__ == "__main__":
    main()
